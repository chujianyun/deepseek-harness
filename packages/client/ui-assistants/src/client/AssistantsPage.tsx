/**
 * The Assistants page: the signed-in tenant's assistants as cards, searchable, each opening a new
 * session or its detail page, with actions to make one the default, copy it, or delete it.
 */

import { useState } from 'react'
import type { AssistantView } from '@deepseek-ai/dsh-assistants/types'
import { Button, IconSearchOutlineRegular, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { AssistantAvatar } from './AssistantAvatar.tsx'
import { AssistantDetailPage } from './AssistantDetail.tsx'
import type { AssistantsInjected } from './assistants-source.ts'
import { CreateAssistantWizard } from './CreateAssistantWizard.tsx'
import css from './AssistantsPage.module.css'

/** Props the page reads from its `main` registration: the translator and the assistants face. */
export type AssistantsPageProps = PropsLocale<'assistants'> & InjectFace<AssistantsInjected>

/**
 * Render the search box and the assistant cards, or the open assistant's detail page.
 * @param props - the `assistants` translator and the assistants face.
 * @returns the page.
 */
export function AssistantsPage(props: AssistantsPageProps) {
  const { t, useAssistants, onChat, onDismiss, onCreate, onLoadOptions, squareAvatar } = props
  const state = useAssistants(snapshot => snapshot.state)
  const failure = useAssistants(snapshot => snapshot.failure)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [openId, setOpenId] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<AssistantView | null>(null)
  const [actionFailure, setActionFailure] = useState<string | null>(null)
  const needle = query.trim().toLowerCase()
  const assistants = state?.assistants ?? []
  const shown = needle === ''
    ? assistants
    : assistants.filter(item => `${item.name}\n${item.description}`.toLowerCase().includes(needle))
  // A deleted assistant, or one of another tenant, closes its detail page.
  const opened = assistants.find(item => item.id === openId)
  const run = async (action: Promise<string | undefined>): Promise<void> => {
    setActionFailure(null)
    const refusal = await action
    if (refusal !== undefined) setActionFailure(refusal)
  }
  const duplicate = async (assistantId: string, open: boolean): Promise<void> => {
    setActionFailure(null)
    const result = await props.onDuplicate(assistantId)
    if (typeof result === 'string') setActionFailure(result)
    else if (open) setOpenId(result.assistantId)
  }
  const alerts = (
    <>
      {failure !== null && (
        <div className={css.alert} role="alert">
          <span>{t('selectFailed', { message: failure })}</span>
          <Button variant="ghost" onClick={onDismiss}>{t('dismiss')}</Button>
        </div>
      )}
      {actionFailure !== null && (
        <div className={css.alert} role="alert">
          <span>{t('actionFailed', { message: actionFailure })}</span>
          <Button variant="ghost" onClick={() => { setActionFailure(null) }}>{t('dismiss')}</Button>
        </div>
      )}
    </>
  )
  const confirm = deleting !== null && (
    <Modal
      open title={t('deleteTitle')} closeLabel={t('dismiss')} onClose={() => { setDeleting(null) }}
      description={t('deleteDescription', { name: deleting.name, count: props.sessionCount(deleting.id) })}
      footer={(
        <>
          <Button variant="outline" onClick={() => { setDeleting(null) }}>{t('cancel')}</Button>
          <Button variant="primary" onClick={() => { setDeleting(null); void run(props.onDelete(deleting.id)) }}>{t('confirmDelete')}</Button>
        </>
      )}
    />
  )
  if (opened !== undefined && state !== undefined) {
    return (
      <>
        <AssistantDetailPage
          key={opened.id} t={t} assistant={opened} isDefault={opened.id === state.defaultId} alerts={alerts}
          onBack={() => { setOpenId(null) }} onChat={onChat} onRead={props.onRead} onUpdate={props.onUpdate}
          onLoadOptions={onLoadOptions} squareAvatar={squareAvatar}
          onSetDefault={() => { void run(props.onSetDefault(opened.id)) }}
          onDuplicate={() => { void duplicate(opened.id, true) }}
          onDelete={() => { setDeleting(opened) }}
        />
        {confirm}
      </>
    )
  }
  return (
    <div className={css.page}>
      <header className={css.header}>
        <div className={css.headerRow}>
          <h1 className={css.title}>{t('title')}</h1>
          {state?.tenantId != null && <Button variant="primary" size="sm" onClick={() => { setCreating(true) }}>{t('create')}</Button>}
        </div>
        <p className={css.intro}>{t('intro')}</p>
      </header>
      {creating && state !== undefined && (
        <CreateAssistantWizard
          t={t} open templates={state.templates} onClose={() => { setCreating(false) }}
          onCreate={onCreate} onLoadOptions={onLoadOptions} squareAvatar={squareAvatar}
        />
      )}
      {alerts}
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
                <button type="button" className={css.open} aria-label={t('open', { name: item.name })} onClick={() => { setOpenId(item.id) }}>
                  <span className={css.cardHead}>
                    <AssistantAvatar avatar={item.avatar} name={item.name} size={36} />
                    <span className={css.name}>{item.name}</span>
                    {item.id === state.defaultId && <Tag tone="neutral">{t('default')}</Tag>}
                  </span>
                  <span className={css.description}>{item.description === '' ? t('noDescription') : item.description}</span>
                </button>
                <div className={css.actions}>
                  {item.id !== state.defaultId && (
                    <Button variant="ghost" size="sm" onClick={() => { void run(props.onSetDefault(item.id)) }}>{t('setDefault')}</Button>
                  )}
                  <Button variant="ghost" size="sm" onClick={() => { void duplicate(item.id, false) }}>{t('duplicate')}</Button>
                  <Button variant="ghost" size="sm" onClick={() => { setDeleting(item) }}>{t('delete')}</Button>
                  <Button variant="outline" size="sm" onClick={() => { void onChat(item.id) }}>{t('chat')}</Button>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
      {confirm}
    </div>
  )
}
