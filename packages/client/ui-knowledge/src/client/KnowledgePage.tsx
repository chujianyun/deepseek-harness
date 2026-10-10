/** The Knowledge page: knowledge bases on the left, the selected one's sources, settings, and recall test on the right. */

import { useState } from 'react'
import type { KnowledgeBaseView } from '@deepseek-ai/dsh-knowledge-base/types'
import { Button, Input, Modal, SegmentedTabs } from '@deepseek-ai/dsh-client-ui-primitives'
import { KnowledgeRecallPanel } from './KnowledgeRecall.tsx'
import { KnowledgeSettingsPanel } from './KnowledgeSettings.tsx'
import { KnowledgeSources } from './KnowledgeSources.tsx'
import { failureText, modelOptions, type KnowledgePageProps, type T } from './shared.ts'
import css from './KnowledgePage.module.css'

export type { KnowledgePageProps } from './shared.ts'

/**
 * Render the knowledge bases and the selected one's files, with dialogs to create, rename, and delete.
 * @param props - the `knowledge` translator and the knowledge face.
 * @returns the page.
 */
export function KnowledgePage(props: KnowledgePageProps) {
  const { t, useKnowledge, onSelect } = props
  const state = useKnowledge(snapshot => snapshot.state)
  const selectedId = useKnowledge(snapshot => snapshot.selectedId)
  const [dialog, setDialog] = useState<'create' | 'rename' | 'delete' | null>(null)
  if (state === undefined) return <div className={css.page} />
  if (state.tenantId === null) {
    return <div className={css.page}><Header t={t} /><p className={css.muted}>{t('signedOut')}</p></div>
  }
  const selected = state.bases.find(base => base.id === selectedId) ?? state.bases[0]
  return (
    <div className={css.page}>
      <Header t={t} />
      <Notice {...props} />
      <div className={css.columns}>
        <nav className={css.list} aria-label={t('title')}>
          <Button variant="outline" onClick={() => { setDialog('create') }}>{t('create')}</Button>
          {state.bases.length === 0 && <p className={css.muted}>{t('listEmpty')}</p>}
          {state.bases.map(base => (
            <button key={base.id} type="button" className={css.listItem} aria-current={base.id === selected?.id ? 'true' : undefined}
              onClick={() => { onSelect(base.id) }}>
              <span className={css.listName}>{base.name}</span>
              <span className={css.listMeta}>{base.items.filter(item => item.parentId === null).length}</span>
            </button>
          ))}
        </nav>
        {selected === undefined
          ? <div className={css.detail}><p className={css.muted}>{t('detailEmpty')}</p></div>
          : <Detail key={selected.id} {...props} base={selected} openRename={() => { setDialog('rename') }} openDelete={() => { setDialog('delete') }} />}
      </div>
      <CreateDialog {...props} open={dialog === 'create'} onClose={() => { setDialog(null) }} />
      {selected !== undefined && <RenameDialog {...props} base={selected} open={dialog === 'rename'} onClose={() => { setDialog(null) }} />}
      {selected !== undefined && <DeleteDialog {...props} base={selected} open={dialog === 'delete'} onClose={() => { setDialog(null) }} />}
    </div>
  )
}

function Header({ t }: { t: T }) {
  return (
    <header className={css.header} data-window-drag>
      <h1 className={css.title}>{t('title')}</h1>
      <p className={css.muted}>{t('intro')}</p>
    </header>
  )
}

/** The failure or addition outcome of the last action. */
function Notice({ t, useKnowledge, onDismiss }: KnowledgePageProps) {
  const failure = useKnowledge(snapshot => snapshot.failure)
  const added = useKnowledge(snapshot => snapshot.added)
  const dismiss = <Button variant="ghost" onClick={onDismiss}>{t('close')}</Button>
  if (failure !== null) {
    return (
      <div className={css.alert} role="alert">
        <span>{failureText(t, failure)}</span>
        {dismiss}
      </div>
    )
  }
  if (added === null) return null
  const problem = added.rejected.length > 0
  return (
    <div className={problem ? css.alert : css.notice} role={problem ? 'alert' : 'status'}>
      <div>
        <p className={css.noticeLine}>{t('added', { count: String(added.added) })}</p>
        {added.rejected.map(entry => <p key={entry.name} className={css.noticeLine}>{t(`reject.${entry.reason}`, { name: entry.name })}</p>)}
      </div>
      {dismiss}
    </div>
  )
}

/** What the detail column shows. */
type View = 'files' | 'settings' | 'recall'

function Detail(props: KnowledgePageProps & { base: KnowledgeBaseView; openRename: () => void; openDelete: () => void }) {
  const { t, base, useKnowledge, openRename, openDelete } = props
  const busy = useKnowledge(snapshot => snapshot.busy)
  const [view, setView] = useState<View>('files')
  const tab = (value: View) => ({ value, label: t(`tab.${value}`), id: `knowledge-tab-${value}`, panelId: `knowledge-panel-${value}` })
  return (
    <section className={css.detail} aria-label={base.name}>
      <div className={css.detailHead}>
        <div className={css.identity}>
          <h2 className={css.baseName}>{base.name}</h2>
          <span className={css.muted}>{t('modelLabel', { name: base.embeddingModelName })}</span>
        </div>
        <div className={css.actions}>
          <SegmentedTabs className={css.tabs} label={t('views')} items={[tab('files'), tab('settings'), tab('recall')]} value={view} onChange={setView} />
          <Button variant="ghost" disabled={busy} onClick={openRename}>{t('rename')}</Button>
          <Button variant="ghost" disabled={busy} onClick={openDelete}>{t('deleteBase')}</Button>
        </div>
      </div>
      {base.status === 'unavailable' && <p className={css.warning}>{t('unavailable')}</p>}
      {base.status === 'rebuilding' && <Rebuilding t={t} base={base} />}
      <div id={`knowledge-panel-${view}`} role="tabpanel" aria-labelledby={`knowledge-tab-${view}`} className={css.panel}>
        {view === 'files' && <KnowledgeSources {...props} />}
        {view === 'settings' && <KnowledgeSettingsPanel {...props} />}
        {view === 'recall' && <KnowledgeRecallPanel {...props} />}
      </div>
    </section>
  )
}

/** Progress of a rebuild for a new embedding model. */
function Rebuilding({ t, base }: { t: T; base: KnowledgeBaseView }) {
  const done = base.items.filter(item => item.status === 'completed' || item.status === 'failed').length
  return (
    <div className={css.rebuild} role="status">
      <span>{t('rebuilding', { done: String(done), total: String(base.items.length) })}</span>
      <progress className={css.progress} max={base.items.length} value={done} aria-label={t('rebuildProgress')} />
    </div>
  )
}

function CreateDialog({ t, useKnowledge, onCreate, open, onClose }: KnowledgePageProps & { open: boolean; onClose: () => void }) {
  const embedding = useKnowledge(snapshot => snapshot.embedding)
  const failure = useKnowledge(snapshot => snapshot.failure)
  const busy = useKnowledge(snapshot => snapshot.busy)
  const [name, setName] = useState('')
  const [model, setModel] = useState('')
  const options = modelOptions(t, embedding)
  const chosen = options.some(option => option.id === model) ? model : options[0]?.id ?? ''
  const api = embedding?.apiModels.some(entry => entry.id === chosen) ?? false
  const close = (): void => { setName(''); setModel(''); onClose() }
  const submit = async (): Promise<void> => { if (await onCreate(name.trim(), chosen)) close() }
  return (
    <Modal open={open} title={t('createTitle')} closeLabel={t('close')} onClose={close} footer={(
      <>
        <Button variant="outline" onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy || name.trim() === '' || chosen === ''} onClick={() => { void submit() }}>{t('confirmCreate')}</Button>
      </>
    )}>
      <div className={css.form}>
        <label className={css.field}>
          <span className={css.label}>{t('name')}</span>
          <Input value={name} placeholder={t('namePlaceholder')} data-autofocus onChange={(event) => { setName(event.target.value) }} />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('model')}</span>
          {options.length === 0
            ? <span className={css.muted}>{t('noModel')}</span>
            : (
              <select className={css.select} value={chosen} onChange={(event) => { setModel(event.target.value) }}>
                {options.map(option => <option key={option.id} value={option.id}>{option.label}</option>)}
              </select>
            )}
        </label>
        {api && <p className={css.muted}>{t('privacy')}</p>}
        {open && failure !== null && <p className={css.fieldError} role="alert">{failureText(t, failure)}</p>}
      </div>
    </Modal>
  )
}

/** Props of a dialog about the selected knowledge base. */
type BaseDialogProps = KnowledgePageProps & { base: KnowledgeBaseView; open: boolean; onClose: () => void }

function RenameDialog({ t, base, useKnowledge, onRename, open, onClose }: BaseDialogProps) {
  const failure = useKnowledge(snapshot => snapshot.failure)
  const busy = useKnowledge(snapshot => snapshot.busy)
  const [name, setName] = useState<string | null>(null)
  const value = name ?? base.name
  const close = (): void => { setName(null); onClose() }
  const submit = async (): Promise<void> => { if (await onRename(base.id, value.trim())) close() }
  return (
    <Modal open={open} title={t('renameTitle')} closeLabel={t('close')} onClose={close} footer={(
      <>
        <Button variant="outline" onClick={close}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy || value.trim() === ''} onClick={() => { void submit() }}>{t('save')}</Button>
      </>
    )}>
      <div className={css.form}>
        <label className={css.field}>
          <span className={css.label}>{t('name')}</span>
          <Input value={value} data-autofocus onChange={(event) => { setName(event.target.value) }} />
        </label>
        {open && failure !== null && <p className={css.fieldError} role="alert">{failureText(t, failure)}</p>}
      </div>
    </Modal>
  )
}

function DeleteDialog({ t, base, useKnowledge, onDelete, open, onClose }: BaseDialogProps) {
  const busy = useKnowledge(snapshot => snapshot.busy)
  return (
    <Modal open={open} title={t('deleteTitle')} description={t('deleteDescription', { name: base.name })} closeLabel={t('close')} onClose={onClose}
      footer={(
        <>
          <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
          <Button variant="primary" disabled={busy} onClick={() => { onClose(); void onDelete(base.id) }}>{t('confirmDelete')}</Button>
        </>
      )} />
  )
}
