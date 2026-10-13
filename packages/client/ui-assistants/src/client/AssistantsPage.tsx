/**
 * The Assistants page: the signed-in tenant's assistants as cards, searchable, each opening a new
 * session or its detail page, with actions to make one the default, copy it, or delete it.
 */

import { useState, type ReactNode } from 'react'
import type { AssistantView } from '@deepseek-ai/dsh-assistants/types'
import {
  Button, IconAgentPresetOutlineRegular, IconCopyOutlineMedium, IconEllipsisOutlineMedium, IconSearchOutlineRegular, IconTrashOutlineMedium,
  IconUserOutlineRegular, Input, Menu, Modal,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import { AssistantAvatar } from './AssistantAvatar.tsx'
import { AssistantDetailPage } from './AssistantDetail.tsx'
import type { AssistantsInjected } from './assistants-source.ts'
import { CreateAssistantWizard } from './CreateAssistantWizard.tsx'
import type { PackagesInjected } from './packages-source.ts'
import { CompanyPackages, PackageTasks } from './PackageViews.tsx'
import css from './AssistantsPage.module.css'

/** The page's injected face: the assistants face with the company packages face, their hooks merged. */
export type AssistantsPageInjected = Omit<AssistantsInjected, 'hooks'> & Omit<PackagesInjected, 'hooks'> & {
  readonly hooks: AssistantsInjected['hooks'] & PackagesInjected['hooks']
}

/** Props the page reads from its `main` registration: the translator, the assistants face, and the company packages face. */
export type AssistantsPageProps = PropsLocale<'assistants'> & InjectFace<AssistantsPageInjected>

/**
 * Render the search box and the assistant cards, or the open assistant's detail page.
 * @param props - the `assistants` translator and the assistants face.
 * @returns the page.
 */
export function AssistantsPage(props: AssistantsPageProps) {
  const { t, useAssistants, useSessions, onChat, onDismiss, onCreate, onLoadOptions, squareAvatar } = props
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
  // An update to a newer package version rewrites core files; the detail page reads them again.
  const openedVersion = props.usePackages(snapshot => snapshot.state?.installed.find(item => item.assistantId === openId)?.version)
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
          key={opened.id} t={t} assistant={opened} alerts={alerts} revision={openedVersion}
          onBack={() => { setOpenId(null) }} onChat={onChat} onRead={props.onRead} onUpdate={props.onUpdate}
          onLoadOptions={onLoadOptions} squareAvatar={squareAvatar} useSessions={useSessions} onOpenSession={props.onOpenSession}
          onDuplicate={() => { void duplicate(opened.id, true) }}
          onDelete={() => { setDeleting(opened) }}
          packageTasks={<PackageTasks {...props} assistantId={opened.id} />}
        />
        {confirm}
      </>
    )
  }
  return (
    <div className={css.page}>
      <header className={css.header} data-window-drag>
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
      {state !== undefined && state.tenantId === null && <EmptyState icon={<IconUserOutlineRegular size={24} className={css.emptyGlyph} />} text={t('signedOut')} />}
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
          {assistants.length === 0 && (
            <EmptyState icon={<IconAgentPresetOutlineRegular size={24} className={css.emptyGlyph} />} text={t('empty')}>
              <Button variant="primary" className={css.emptyAction} onClick={() => { setCreating(true) }}>{t('create')}</Button>
            </EmptyState>
          )}
          {assistants.length > 0 && shown.length === 0 && (
            <EmptyState icon={<IconSearchOutlineRegular size={24} className={css.emptyGlyph} />} text={t('noMatch')} />
          )}
          <ul className={css.grid}>
            {shown.map(item => (
              <li key={item.id} className={css.card} data-assistant-id={item.id}>
                <button type="button" className={css.open} aria-label={t('open', { name: item.name })} onClick={() => { setOpenId(item.id) }}>
                  <span className={css.cardHead}>
                    <AssistantAvatar avatar={item.avatar} name={item.name} size={36} />
                    <span className={css.name}>{item.name}</span>
                  </span>
                  <span className={css.description}>{item.description === '' ? t('noDescription') : item.description}</span>
                </button>
                <div className={css.actions}>
                  <CardMenu
                    t={t} name={item.name} onDuplicate={() => { void duplicate(item.id, false) }} onDelete={() => { setDeleting(item) }}
                  />
                  <Button variant="primary" size="sm" onClick={() => { void onChat(item.id) }}>{t('chat')}</Button>
                </div>
              </li>
            ))}
          </ul>
          <CompanyPackages {...props} onOpen={setOpenId} />
        </>
      )}
      {confirm}
    </div>
  )
}

/** An empty state: a 24px glyph, one line of explanation, and an optional primary action. */
function EmptyState({ icon, text, children }: { icon: ReactNode; text: string; children?: ReactNode }) {
  return <div className={css.empty} role="status">{icon}<p>{text}</p>{children}</div>
}

/**
 * A card's ⋯ menu: 复制 and a destructive 删除 (which still asks for confirmation), portaled so the page's scroll box does not clip it.
 * @param props - the translator, the assistant name for the trigger's label, and the two actions.
 * @returns the menu with its trigger.
 */
function CardMenu({ t, name, onDuplicate, onDelete }: {
  t: AssistantsPageProps['t']
  name: string
  onDuplicate: () => void
  onDelete: () => void
}) {
  const [open, setOpen] = useState(false)
  return (
    <Menu open={open} side="bottom" align="end" portal autoFocus
      anchor={(
        <Button variant="ghost" size="sm" className={css.more} aria-label={t('more', { name })} aria-haspopup="menu" aria-expanded={open}
          onClick={() => { setOpen(value => !value) }}>
          <IconEllipsisOutlineMedium size={16} />
        </Button>
      )}
      items={[
        { id: 'duplicate', label: t('duplicate'), icon: <IconCopyOutlineMedium size={16} /> },
        { id: 'delete', label: t('delete'), icon: <IconTrashOutlineMedium size={16} />, danger: true },
      ]}
      onClose={() => { setOpen(false) }}
      onSelect={(id) => {
        setOpen(false)
        if (id === 'duplicate') onDuplicate()
        else onDelete()
      }} />
  )
}
