/**
 * A knowledge base's sources, one tab per kind: files dropped or picked, folders whose supported
 * files become their items, web pages fetched on this machine, and notes written here.
 */

import { useRef, useState, type DragEvent, type ReactNode } from 'react'
import type { KnowledgeBaseView, KnowledgeItemKind, KnowledgeItemView } from '@deepseek-ai/dsh-knowledge-base/types'
import { Button, fileSizeText, Input, Modal, SegmentedTabs, Tag } from '@deepseek-ai/dsh-client-ui-primitives'
import { failureText, type KnowledgePageProps, type T } from './shared.ts'
import css from './KnowledgePage.module.css'

/** The Desktop preload bridge: the real path of a dropped or picked file or folder, '' when it has none. */
interface HostPathBridge {
  pathFor(file: File): string
}

type SourceProps = KnowledgePageProps & { base: KnowledgeBaseView }

const STATUS_TONE = { pending: 'neutral', processing: 'info', completed: 'success', failed: 'danger' } as const

function bridge(): HostPathBridge | undefined {
  return (globalThis as { __DSH_HOST_PATHS__?: HostPathBridge }).__DSH_HOST_PATHS__
}

/** Local paths of picked or dropped files; files without one are left out. */
function pathsOf(files: FileList | null): string[] {
  return [...files ?? []].map(file => bridge()?.pathFor(file) ?? '').filter(path => path !== '')
}

/**
 * The folder a directory picker chose: the path of any file it listed, cut back to the folder named
 * first in that file's path relative to the choice.
 */
function pickedFolder(files: FileList | null): string {
  const file = files?.[0]
  if (file === undefined) return ''
  const path = bridge()?.pathFor(file) ?? ''
  const relative = file.webkitRelativePath
  if (path === '' || relative === '') return ''
  return path.slice(0, path.length - relative.length) + (relative.split('/')[0] as string)
}

/** Items of a kind shown at the top level: a folder's files show under their folder. */
const topLevel = (base: KnowledgeBaseView, kind: KnowledgeItemKind): KnowledgeItemView[] =>
  base.items.filter(item => item.kind === kind && item.parentId === null)

/**
 * Render the sources tabs of the selected knowledge base.
 * @param props - the page props and the knowledge base.
 * @returns the tabs and the selected kind's list.
 */
export function KnowledgeSources(props: SourceProps) {
  const { t, base } = props
  const [tab, setTab] = useState<KnowledgeItemKind>('file')
  const item = (value: KnowledgeItemKind) => ({
    value, label: `${t(`source.${value}`)} ${String(topLevel(base, value).length)}`, id: `knowledge-source-${value}`, panelId: `knowledge-source-panel-${value}`,
  })
  return (
    <>
      <SegmentedTabs className={css.sourceTabs} label={t('sources')} items={[item('file'), item('folder'), item('url'), item('note')]} value={tab} onChange={setTab} />
      <div id={`knowledge-source-panel-${tab}`} role="tabpanel" aria-labelledby={`knowledge-source-${tab}`} className={css.panel}>
        {tab === 'file' && <FilesPane {...props} />}
        {tab === 'folder' && <FoldersPane {...props} />}
        {tab === 'url' && <UrlsPane {...props} />}
        {tab === 'note' && <NotesPane {...props} />}
      </div>
    </>
  )
}

function StatusCell({ t, item }: { t: T; item: KnowledgeItemView }) {
  return (
    <td>
      <Tag tone={STATUS_TONE[item.status]}>{t(`status.${item.status}`)}</Tag>
      {item.error !== null && <span className={css.itemError}>{t(`error.${item.error}`)}</span>}
    </td>
  )
}

/** Chunk count once something is indexed: a failed page keeps its last copy's chunks. */
const chunksOf = (item: KnowledgeItemView): ReactNode => (item.chunkCount > 0 ? item.chunkCount : '–')

function RowActions(props: SourceProps & { item: KnowledgeItemView; children?: ReactNode }) {
  const { t, base, item, useKnowledge, onReprocess, onDeleteItem, children } = props
  const busy = useKnowledge(snapshot => snapshot.busy)
  const settled = item.status === 'completed' || item.status === 'failed'
  return (
    <td className={css.rowActions} aria-label={t('itemActions', { name: item.name })}>
      {children}
      {settled && <Button variant="ghost" disabled={busy} onClick={() => { void onReprocess(base.id, item.id) }}>{t('reprocess')}</Button>}
      <Button variant="ghost" disabled={busy} onClick={() => { void onDeleteItem(base.id, item.id) }}>{t('deleteItem')}</Button>
    </td>
  )
}

function DropZone({ hint, onDrop, children }: { hint: string; onDrop: (files: FileList) => void; children: ReactNode }) {
  const [dragging, setDragging] = useState(false)
  const drop = (event: DragEvent<HTMLDivElement>): void => {
    event.preventDefault()
    setDragging(false)
    onDrop(event.dataTransfer.files)
  }
  return (
    <div className={css.dropZone} data-dragging={dragging} onDragOver={(event) => { event.preventDefault(); setDragging(true) }}
      onDragLeave={() => { setDragging(false) }} onDrop={drop}>
      <span className={css.muted}>{hint}</span>
      {children}
    </div>
  )
}

function FilesPane(props: SourceProps) {
  const { t, base, useKnowledge, onAddFiles } = props
  const busy = useKnowledge(snapshot => snapshot.busy)
  const input = useRef<HTMLInputElement>(null)
  const [noPath, setNoPath] = useState(false)
  const add = (files: FileList | null): void => {
    const paths = pathsOf(files)
    setNoPath(paths.length === 0 && (files?.length ?? 0) > 0)
    if (paths.length > 0) void onAddFiles(base.id, paths)
  }
  const items = topLevel(base, 'file')
  return (
    <>
      {noPath && <p className={css.alert} role="alert">{t('noPath')}</p>}
      <DropZone hint={t('dropHint')} onDrop={add}>
        <Button variant="primary" disabled={busy} onClick={() => { input.current?.click() }}>{t('addFiles')}</Button>
        <input ref={input} className={css.fileInput} type="file" multiple accept=".docx,.pdf,.xlsx,.md,.markdown,.txt" aria-label={t('addFiles')}
          onChange={(event) => { add(event.target.files); event.target.value = '' }} />
      </DropZone>
      {items.length === 0 ? <p className={css.muted}>{t('itemsEmpty')}</p> : (
        <table className={css.table}>
          <thead>
            <tr><th>{t('columnName')}</th><th>{t('columnSize')}</th><th>{t('columnStatus')}</th><th>{t('columnChunks')}</th><th /></tr>
          </thead>
          <tbody>
            {items.map(item => (
              <tr key={item.id}>
                <td className={css.itemName}>{item.name}</td>
                <td>{fileSizeText(item.size)}</td>
                <StatusCell t={t} item={item} />
                <td>{chunksOf(item)}</td>
                <RowActions {...props} item={item} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function FoldersPane(props: SourceProps) {
  const { t, base, useKnowledge, onAddFolder } = props
  const busy = useKnowledge(snapshot => snapshot.busy)
  const input = useRef<HTMLInputElement | null>(null)
  const [noPath, setNoPath] = useState(false)
  const add = (path: string): void => {
    setNoPath(path === '')
    if (path !== '') void onAddFolder(base.id, path)
  }
  const folders = topLevel(base, 'folder')
  return (
    <>
      {noPath && <p className={css.alert} role="alert">{t('noFolderPath')}</p>}
      <DropZone hint={t('folderHint')} onDrop={(files) => { add(files[0] === undefined ? '' : bridge()?.pathFor(files[0]) ?? '') }}>
        <Button variant="primary" disabled={busy} onClick={() => { input.current?.click() }}>{t('addFolder')}</Button>
        <input ref={(element) => {
          input.current = element
          // React does not know the directory-picker attribute.
          element?.setAttribute('webkitdirectory', '')
        }} className={css.fileInput} type="file" aria-label={t('addFolder')}
        onChange={(event) => { add(pickedFolder(event.target.files)); event.target.value = '' }} />
      </DropZone>
      {folders.length === 0 ? <p className={css.muted}>{t('foldersEmpty')}</p> : folders.map(folder => <Folder key={folder.id} {...props} folder={folder} />)}
    </>
  )
}

function Folder(props: SourceProps & { folder: KnowledgeItemView }) {
  const { t, base, folder } = props
  const [open, setOpen] = useState(false)
  const [showSkipped, setShowSkipped] = useState(false)
  const files = base.items.filter(item => item.parentId === folder.id)
  return (
    <section className={css.folder} aria-label={folder.name}>
      <table className={css.table}>
        <tbody>
          <tr>
            <td className={css.itemName}>
              <span className={css.folderName}>{folder.name}</span>
              <span className={css.itemSource}>{folder.source}</span>
            </td>
            <td>{t('folderFiles', { count: String(files.length) })}</td>
            <td>{fileSizeText(folder.size)}</td>
            <StatusCell t={t} item={folder} />
            <td>{chunksOf(folder)}</td>
            <RowActions {...props} item={folder}>
              <Button variant="ghost" aria-expanded={open} onClick={() => { setOpen(!open) }}>{t(open ? 'collapse' : 'expand')}</Button>
            </RowActions>
          </tr>
        </tbody>
      </table>
      {folder.skippedCount > 0 && (
        <div className={css.skipped}>
          <button type="button" className={css.linkButton} aria-expanded={showSkipped} onClick={() => { setShowSkipped(!showSkipped) }}>
            {t('skippedCount', { count: String(folder.skippedCount) })}
          </button>
          {showSkipped && (
            <ul className={css.skippedList} aria-label={t('skippedList')}>
              {folder.skipped.map(entry => <li key={entry.path}>{t(`skipped.${entry.reason}`, { path: entry.path })}</li>)}
              {folder.skippedCount > folder.skipped.length && <li>{t('skippedMore', { count: String(folder.skippedCount - folder.skipped.length) })}</li>}
            </ul>
          )}
        </div>
      )}
      {open && (
        <table className={css.table} aria-label={t('folderItems', { name: folder.name })}>
          <thead>
            <tr><th>{t('columnPath')}</th><th>{t('columnSize')}</th><th>{t('columnStatus')}</th><th>{t('columnChunks')}</th></tr>
          </thead>
          <tbody>
            {files.map(file => (
              <tr key={file.id}>
                <td className={css.itemName}>{file.source}</td>
                <td>{fileSizeText(file.size)}</td>
                <StatusCell t={t} item={file} />
                <td>{chunksOf(file)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function UrlsPane(props: SourceProps) {
  const { t, base, useKnowledge, onAddUrl } = props
  const busy = useKnowledge(snapshot => snapshot.busy)
  const [url, setUrl] = useState('')
  const pages = topLevel(base, 'url')
  const submit = async (): Promise<void> => { if (await onAddUrl(base.id, url.trim())) setUrl('') }
  return (
    <>
      <form className={css.recallForm} onSubmit={(event) => { event.preventDefault(); if (url.trim() !== '') void submit() }}>
        <Input value={url} placeholder={t('urlPlaceholder')} aria-label={t('urlPlaceholder')} onChange={(event) => { setUrl(event.target.value) }} />
        <Button variant="primary" type="submit" disabled={busy || url.trim() === ''}>{t('addUrl')}</Button>
      </form>
      <p className={css.muted}>{t('urlHint')}</p>
      {pages.length === 0 ? <p className={css.muted}>{t('urlsEmpty')}</p> : (
        <table className={css.table}>
          <thead>
            <tr><th>{t('columnPage')}</th><th>{t('columnSize')}</th><th>{t('columnStatus')}</th><th>{t('columnChunks')}</th><th /></tr>
          </thead>
          <tbody>
            {pages.map(page => (
              <tr key={page.id}>
                <td className={css.itemName}>
                  <span>{page.name}</span>
                  {page.name !== page.source && <span className={css.itemSource}>{page.source}</span>}
                </td>
                <td>{page.size > 0 ? fileSizeText(page.size) : '–'}</td>
                <StatusCell t={t} item={page} />
                <td>{chunksOf(page)}</td>
                <RowActions {...props} item={page} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

/** The note being written: a new one, or an existing one by id. */
type Editing = { readonly itemId: string | null; readonly title: string; readonly content: string }

/** Longest note body; the Host refuses more. */
const MAX_NOTE_CHARS = 1_000_000

function NotesPane(props: SourceProps) {
  const { t, base, useKnowledge, onLoadNote } = props
  const busy = useKnowledge(snapshot => snapshot.busy)
  const [editing, setEditing] = useState<Editing | null>(null)
  const notes = topLevel(base, 'note')
  const edit = async (note: KnowledgeItemView): Promise<void> => {
    const loaded = await onLoadNote(base.id, note.id)
    if (loaded !== undefined) setEditing({ itemId: note.id, ...loaded })
  }
  return (
    <>
      <div className={css.paneHead}>
        <span className={css.muted}>{t('noteHint')}</span>
        <Button variant="primary" disabled={busy} onClick={() => { setEditing({ itemId: null, title: '', content: '' }) }}>{t('newNote')}</Button>
      </div>
      {notes.length === 0 ? <p className={css.muted}>{t('notesEmpty')}</p> : (
        <table className={css.table}>
          <thead>
            <tr><th>{t('columnTitle')}</th><th>{t('columnSize')}</th><th>{t('columnStatus')}</th><th>{t('columnChunks')}</th><th /></tr>
          </thead>
          <tbody>
            {notes.map(note => (
              <tr key={note.id}>
                <td className={css.itemName}>{note.name}</td>
                <td>{fileSizeText(note.size)}</td>
                <StatusCell t={t} item={note} />
                <td>{chunksOf(note)}</td>
                <RowActions {...props} item={note}>
                  <Button variant="ghost" disabled={busy} onClick={() => { void edit(note) }}>{t('editNote')}</Button>
                </RowActions>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {editing !== null && <NoteDialog {...props} editing={editing} onClose={() => { setEditing(null) }} />}
    </>
  )
}

function NoteDialog(props: SourceProps & { editing: Editing; onClose: () => void }) {
  const { t, base, useKnowledge, onCreateNote, onUpdateNote, editing, onClose } = props
  const busy = useKnowledge(snapshot => snapshot.busy)
  const failure = useKnowledge(snapshot => snapshot.failure)
  const [title, setTitle] = useState(editing.title)
  const [content, setContent] = useState(editing.content)
  const tooLong = content.length > MAX_NOTE_CHARS
  const save = async (): Promise<void> => {
    const saving = editing.itemId === null
      ? onCreateNote(base.id, title.trim(), content)
      : onUpdateNote(base.id, editing.itemId, title.trim(), content)
    if (await saving) onClose()
  }
  return (
    <Modal open title={t(editing.itemId === null ? 'newNote' : 'editNote')} closeLabel={t('close')} onClose={onClose} footer={(
      <>
        <Button variant="outline" onClick={onClose}>{t('cancel')}</Button>
        <Button variant="primary" disabled={busy || title.trim() === '' || tooLong} onClick={() => { void save() }}>{t('save')}</Button>
      </>
    )}>
      <div className={css.form}>
        <label className={css.field}>
          <span className={css.label}>{t('noteTitle')}</span>
          <Input value={title} data-autofocus onChange={(event) => { setTitle(event.target.value) }} />
        </label>
        <label className={css.field}>
          <span className={css.label}>{t('noteContent')}</span>
          <textarea className={css.textarea} value={content} rows={14} onChange={(event) => { setContent(event.target.value) }} />
        </label>
        <span className={tooLong ? css.fieldError : css.muted} role={tooLong ? 'alert' : undefined}>
          {t(tooLong ? 'noteTooLong' : 'noteLength', { count: content.length.toLocaleString('en-US'), max: MAX_NOTE_CHARS.toLocaleString('en-US') })}
        </span>
        {failure !== null && <p className={css.fieldError} role="alert">{failureText(t, failure)}</p>}
      </div>
    </Modal>
  )
}
