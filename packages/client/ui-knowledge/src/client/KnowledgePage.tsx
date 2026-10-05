/** The Knowledge page: knowledge bases on the left, the selected one's files on the right. */

import { useRef, useState, type DragEvent } from 'react'
import type { EmbeddingState } from '@deepseek-ai/dsh-embedding/types'
import type { KnowledgeBaseView, KnowledgeItemView } from '@deepseek-ai/dsh-knowledge-base/types'
import { Button, fileSizeText, Input, Modal, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsLocale, TranslateNS } from '@deepseek-ai/dsh-client-ui-slots'
import type { KnowledgeFailure, KnowledgeInjected } from './knowledge-source.ts'
import css from './KnowledgePage.module.css'

/** Props the page reads from its `main` registration: the translator and the knowledge face. */
export type KnowledgePageProps = PropsLocale<'knowledge'> & InjectFace<KnowledgeInjected>

type T = TranslateNS<'knowledge'>

/** The Desktop preload bridge: the real path of a dropped or picked file, '' when it has none. */
interface HostPathBridge {
  pathFor(file: File): string
}

const STATUS_TONE = { pending: 'neutral', processing: 'info', completed: 'success', failed: 'danger' } as const

/** Local paths of picked or dropped files; files without one are left out. */
function pathsOf(files: FileList | null): string[] {
  const bridge = (globalThis as { __DSH_HOST_PATHS__?: HostPathBridge }).__DSH_HOST_PATHS__
  return [...files ?? []].map(file => bridge?.pathFor(file) ?? '').filter(path => path !== '')
}

/** Embedding models a new knowledge base can use, with the label the select shows. */
function modelOptions(t: T, embedding: EmbeddingState | undefined): { id: string; label: string }[] {
  if (embedding === undefined) return []
  const { local } = embedding
  const options = local.status === 'unsupported' ? []
    : [{ id: local.id, label: t(local.status === 'installed' ? 'modelLocal' : 'modelLocalPending', { name: local.name }) }]
  return [...options, ...embedding.apiModels.map(model => ({ id: model.id, label: `${model.model} · ${model.providerName}` }))]
}

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
              <span className={css.listMeta}>{base.items.length}</span>
            </button>
          ))}
        </nav>
        {selected === undefined
          ? <div className={css.detail}><p className={css.muted}>{t('detailEmpty')}</p></div>
          : <Detail {...props} base={selected} openRename={() => { setDialog('rename') }} openDelete={() => { setDialog('delete') }} />}
      </div>
      <CreateDialog {...props} open={dialog === 'create'} onClose={() => { setDialog(null) }} />
      {selected !== undefined && <RenameDialog {...props} base={selected} open={dialog === 'rename'} onClose={() => { setDialog(null) }} />}
      {selected !== undefined && <DeleteDialog {...props} base={selected} open={dialog === 'delete'} onClose={() => { setDialog(null) }} />}
    </div>
  )
}

function Header({ t }: { t: T }) {
  return (
    <header className={css.header}>
      <h1 className={css.title}>{t('title')}</h1>
      <p className={css.muted}>{t('intro')}</p>
    </header>
  )
}

function failureText(t: T, failure: KnowledgeFailure): string {
  return failure.reason === 'other' ? t('actionFailed', { message: failure.message }) : t(`failure.${failure.reason}`)
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

function Detail(props: KnowledgePageProps & { base: KnowledgeBaseView; openRename: () => void; openDelete: () => void }) {
  const { t, base, useKnowledge, onAddFiles, openRename, openDelete } = props
  const busy = useKnowledge(snapshot => snapshot.busy)
  const input = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [noPath, setNoPath] = useState(false)
  const add = (files: FileList | null): void => {
    const paths = pathsOf(files)
    setNoPath(paths.length === 0 && (files?.length ?? 0) > 0)
    if (paths.length > 0) void onAddFiles(base.id, paths)
  }
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    add(event.dataTransfer.files)
  }
  return (
    <section className={css.detail} aria-label={base.name}>
      <div className={css.detailHead}>
        <div className={css.identity}>
          <h2 className={css.baseName}>{base.name}</h2>
          <span className={css.muted}>{t('modelLabel', { name: base.embeddingModelName })}</span>
        </div>
        <div className={css.actions}>
          <Button variant="ghost" disabled={busy} onClick={openRename}>{t('rename')}</Button>
          <Button variant="ghost" disabled={busy} onClick={openDelete}>{t('deleteBase')}</Button>
        </div>
      </div>
      {base.status === 'unavailable' && <p className={css.warning}>{t('unavailable')}</p>}
      {noPath && <p className={css.alert} role="alert">{t('noPath')}</p>}
      <div className={css.dropZone} data-dragging={dragging} onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
        onDragLeave={() => { setDragging(false) }} onDrop={drop}>
        <span className={css.muted}>{t('dropHint')}</span>
        <Button variant="primary" disabled={busy} onClick={() => { input.current?.click() }}>{t('addFiles')}</Button>
        <input ref={input} className={css.fileInput} type="file" multiple accept=".docx,.pdf,.md,.markdown,.txt" aria-label={t('addFiles')}
          onChange={(event) => { add(event.target.files); event.target.value = '' }} />
      </div>
      <h3 className={css.sectionTitle}>{t('files')}</h3>
      {base.items.length === 0 ? <p className={css.muted}>{t('itemsEmpty')}</p> : <Items {...props} />}
    </section>
  )
}

function Items({ t, base, useKnowledge, onReprocess, onDeleteItem }: KnowledgePageProps & { base: KnowledgeBaseView }) {
  const busy = useKnowledge(snapshot => snapshot.busy)
  return (
    <table className={css.table}>
      <thead>
        <tr><th>{t('columnName')}</th><th>{t('columnSize')}</th><th>{t('columnStatus')}</th><th>{t('columnChunks')}</th><th /></tr>
      </thead>
      <tbody>
        {base.items.map((item: KnowledgeItemView) => (
          <tr key={item.id}>
            <td className={css.itemName}>{item.name}</td>
            <td>{fileSizeText(item.size)}</td>
            <td>
              <Tag tone={STATUS_TONE[item.status]}>{t(`status.${item.status}`)}</Tag>
              {item.error !== null && <span className={css.itemError}>{t(`error.${item.error}`)}</span>}
            </td>
            <td>{item.status === 'completed' ? item.chunkCount : '–'}</td>
            <td className={css.rowActions} aria-label={t('itemActions', { name: item.name })}>
              {(item.status === 'completed' || item.status === 'failed') && (
                <Button variant="ghost" disabled={busy} onClick={() => { void onReprocess(base.id, item.id) }}>{t('reprocess')}</Button>
              )}
              <Button variant="ghost" disabled={busy} onClick={() => { void onDeleteItem(base.id, item.id) }}>{t('deleteItem')}</Button>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
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
